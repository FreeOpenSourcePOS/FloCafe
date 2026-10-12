'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { useFormatDate } from '@/hooks/useFormatDate';
import type { Order } from '@/lib/types';
import {
  CUSTOMER_DISPLAY_DEFAULTS,
  isCustomerDisplayConfig,
  type CustomerDisplayConfig,
} from '@/lib/customer-display';

function getCustomerOrderNumber(order: Order): string {
  return order.bill?.bill_number || order.order_number;
}

export default function CustomerDisplayPage() {
  const router = useRouter();
  const t = useTranslations('customerDisplay');
  const tc = useTranslations('common');
  const { formatTime } = useFormatDate();
  const { user, currentTenant, loading: authLoading, loadFromStorage } = useAuthStore();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [config, setConfig] = useState<CustomerDisplayConfig>(CUSTOMER_DISPLAY_DEFAULTS);

  useEffect(() => {
    loadFromStorage();
  }, [loadFromStorage]);

  useEffect(() => {
    if (!authLoading && !user) {
      router.replace('/auth/login?redirect=/customer-display');
    }
  }, [authLoading, user, router]);

  const fetchOrders = async () => {
    try {
      const { data: latestConfig } = await api
        .get('/settings/customer-display')
        .catch(() => ({ data: null }));
      const validConfig = isCustomerDisplayConfig(latestConfig) ? latestConfig : null;
      const activeConfig: CustomerDisplayConfig = validConfig ?? config;
      if (validConfig) setConfig(validConfig);
      const { data } = await api.get('/orders', { params: { per_page: 50 } });
      const nextOrders = (data.orders || [])
        .filter((order: Order) => (activeConfig.statuses as string[]).includes(order.status))
        .sort((a: Order, b: Order) => a.created_at.localeCompare(b.created_at));
      setOrders(nextOrders);
      setError(false);
      setLastUpdated(new Date());
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!user || !currentTenant) return;
    const initial = setTimeout(fetchOrders, 0);
    const interval = setInterval(fetchOrders, config.refresh_seconds * 1000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [user, currentTenant, config.refresh_seconds]);

  const preparing = useMemo(
    () => orders.filter((order) => order.status === 'pending' || order.status === 'preparing'),
    [orders],
  );
  const ready = useMemo(() => orders.filter((order) => order.status === 'ready'), [orders]);
  const showPreparing = config.statuses.some((status) => status !== 'ready');
  const showReady = config.statuses.includes('ready');

  if (authLoading || !user || !currentTenant) {
    return (
      <main className="flex h-screen min-h-0 flex-col items-center justify-center bg-slate-950 text-white">
        <div className="text-slate-400">{tc('loading')}</div>
      </main>
    );
  }

  return (
    <main className="flex h-screen min-h-0 flex-col bg-slate-950 text-white p-6 md:p-10 select-none">
      <header className="max-w-7xl mx-auto flex shrink-0 items-end justify-between gap-4 mb-8">
        <div>
          <div className="text-2xl md:text-3xl font-bold tracking-tight">
            {currentTenant.business_name}
          </div>
          <div className="text-slate-400 mt-1 text-sm md:text-base">{t('orderStatus')}</div>
        </div>
        <div className="text-end text-xs text-slate-500">
          {error
            ? t('connectionProblem')
            : lastUpdated
              ? config.show_updated
                ? t('updatedAt', { time: formatTime(lastUpdated, { second: '2-digit' }) })
                : null
              : t('connecting')}
        </div>
      </header>

      {loading ? (
        <div className="max-w-7xl mx-auto text-center text-slate-400 py-20">
          {t('loadingOrders')}
        </div>
      ) : (
        <div
          className={`max-w-7xl mx-auto grid flex-1 min-h-0 grid-cols-1 ${showPreparing && showReady ? 'md:grid-cols-2' : ''} gap-6 overflow-y-auto md:overflow-hidden`}
        >
          {showPreparing && (
            <section className="rounded-3xl bg-blue-950/60 border border-blue-900/70 overflow-hidden flex flex-col md:min-h-0">
              <div className="px-6 py-5 bg-blue-900/50 border-b border-blue-800/60 shrink-0">
                <h1 className="text-2xl md:text-3xl font-extrabold tracking-wide uppercase">
                  {t('preparingTitle')}
                </h1>
                <p className="text-blue-200/70 mt-1">{t('preparingHint')}</p>
              </div>
              <div
                data-testid="customer-display-preparing-scroll"
                className="p-6 grid grid-cols-2 sm:grid-cols-3 gap-4 md:flex-1 md:min-h-0 md:overflow-y-auto"
              >
                {preparing.length === 0 ? (
                  <div className="col-span-full py-12 text-center text-slate-500 text-lg">
                    {t('noPreparing')}
                  </div>
                ) : (
                  preparing.map((order) => (
                    <div
                      key={order.id}
                      className="rounded-2xl bg-slate-900/80 border border-blue-900/60 p-5 text-center"
                    >
                      <div className="text-xs uppercase tracking-widest text-slate-500 mb-2">
                        {t('orderLabel')}
                      </div>
                      <div className="text-3xl md:text-4xl font-black">
                        {getCustomerOrderNumber(order)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          )}

          {showReady && (
            <section className="rounded-3xl bg-emerald-950/60 border border-emerald-900/70 overflow-hidden flex flex-col md:min-h-0">
              <div className="px-6 py-5 bg-emerald-900/50 border-b border-emerald-800/60 shrink-0">
                <h1 className="text-2xl md:text-3xl font-extrabold tracking-wide uppercase">
                  {t('readyTitle')}
                </h1>
                <p className="text-emerald-200/70 mt-1">{t('readyHint')}</p>
              </div>
              <div
                data-testid="customer-display-ready-scroll"
                className="p-6 grid grid-cols-2 sm:grid-cols-3 gap-4 md:flex-1 md:min-h-0 md:overflow-y-auto"
              >
                {ready.length === 0 ? (
                  <div className="col-span-full py-12 text-center text-slate-500 text-lg">
                    {t('noReady')}
                  </div>
                ) : (
                  ready.map((order) => (
                    <div
                      key={order.id}
                      className="rounded-2xl bg-slate-900/80 border border-emerald-900/60 p-5 text-center"
                    >
                      <div className="text-xs uppercase tracking-widest text-slate-500 mb-2">
                        {t('orderLabel')}
                      </div>
                      <div className="text-3xl md:text-4xl font-black">
                        {getCustomerOrderNumber(order)}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
