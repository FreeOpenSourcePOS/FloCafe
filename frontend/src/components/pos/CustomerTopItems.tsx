'use client';

import { useEffect, useState } from 'react';
import { History } from 'lucide-react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { useCartStore } from '@/store/cart';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import type { Product } from '@/lib/types';
import {
  customerTopItemsView,
  fetchCustomerTopItems,
  type CustomerTopItemsResult,
  type CustomerTopItemsView,
} from '@/lib/customer-top-items';

interface Props {
  products: Product[];
  /** Receives the current catalog product, so it enters the same flow as a menu tap. */
  onSelect: (product: Product) => void;
}

export default function CustomerTopItems({ products, onSelect }: Props) {
  const rawCustomerId = useCartStore((s) => s.customer?.id ?? null);
  const customerId = rawCustomerId === null ? null : String(rawCustomerId);
  const [result, setResult] = useState<CustomerTopItemsResult | null>(null);

  // Drop the previous customer's list during render so it never flashes under the new name.
  const [syncedCustomerId, setSyncedCustomerId] = useState(customerId);
  if (customerId !== syncedCustomerId) {
    setSyncedCustomerId(customerId);
    setResult(null);
  }

  useEffect(() => {
    if (customerId === null) return;
    const controller = new AbortController();
    void fetchCustomerTopItems((url, config) => api.get(url, config), customerId, controller.signal, setResult);
    return () => controller.abort();
  }, [customerId]);

  return <CustomerTopItemsList view={customerTopItemsView(customerId, result, products)} onSelect={onSelect} />;
}

export function CustomerTopItemsList({ view, onSelect }: { view: CustomerTopItemsView; onSelect: (product: Product) => void }) {
  const t = useTranslations('pos');
  const formatNumber = useFormatNumber();

  if (view.kind === 'hidden') return null;

  const status = view.kind === 'loading'
    ? t('loadingEllipsis')
    : view.kind === 'empty'
      ? t('topItemsEmpty')
      : view.kind === 'error'
        ? t('topItemsLoadFailed')
        : null;

  return (
    <div data-testid="customer-top-items" className="mt-1.5 flex min-w-0 items-center gap-1.5 overflow-x-auto">
      <span className="flex shrink-0 items-center gap-1 text-xs font-medium text-muted-foreground">
        <History size={12} aria-hidden="true" />
        {t('topItems')}
      </span>
      {status !== null && (
        <span data-testid="customer-top-items-status" className="text-xs text-muted-foreground">{status}</span>
      )}
      {view.kind === 'items' && view.items.map((item) => {
        const product = item.product;
        return (
          <button
            key={item.product_id}
            type="button"
            data-testid="customer-top-item"
            disabled={!product}
            onClick={product ? () => onSelect(product) : undefined}
            title={product ? item.product_name : t('topItemUnavailable')}
            aria-label={product ? item.product_name : `${item.product_name} (${t('topItemUnavailable')})`}
            className="inline-flex min-h-9 max-w-48 shrink-0 items-center gap-1 rounded-full border border-border bg-card px-3 text-xs font-medium text-foreground transition-colors hover:border-brand/40 hover:bg-muted active:bg-muted touch-manipulation focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:opacity-50 disabled:line-through disabled:hover:border-border disabled:hover:bg-card"
          >
            <span className="truncate">{item.product_name}</span>
            <span className="shrink-0 tabular-nums text-muted-foreground">×{formatNumber(item.total_quantity)}</span>
          </button>
        );
      })}
    </div>
  );
}
