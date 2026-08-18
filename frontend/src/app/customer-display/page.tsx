'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import type { Order } from '@/lib/types';

const ACTIVE_STATUSES = new Set<Order['status']>(['pending', 'preparing', 'ready']);

function getCustomerOrderNumber(order: Order): string {
  return order.bill?.bill_number || order.order_number;
}

export default function CustomerDisplayPage() {
  const router = useRouter();
  const { user, currentTenant, loading: authLoading, loadFromStorage } = useAuthStore();
  const [orders, setOrders] = useState<Order[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

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
      const { data } = await api.get('/orders', { params: { per_page: 50 } });
      const nextOrders = (data.orders || [])
        .filter((order: Order) => ACTIVE_STATUSES.has(order.status))
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
    const interval = setInterval(fetchOrders, 3000);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
    };
  }, [user, currentTenant]);

  const preparing = useMemo(
    () => orders.filter((order) => order.status === 'pending' || order.status === 'preparing'),
    [orders],
  );
  const ready = useMemo(() => orders.filter((order) => order.status === 'ready'), [orders]);

  if (authLoading || !user || !currentTenant) {
    return (
      <main className="min-h-screen bg-slate-950 text-white flex items-center justify-center">
        <div className="text-slate-400">Loading…</div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-slate-950 text-white p-6 md:p-10 select-none">
      <header className="max-w-7xl mx-auto flex items-end justify-between gap-4 mb-8">
        <div>
          <div className="text-2xl md:text-3xl font-bold tracking-tight">{currentTenant.business_name}</div>
          <div className="text-slate-400 mt-1 text-sm md:text-base">Order status</div>
        </div>
        <div className="text-end text-xs text-slate-500">
          {error ? 'Connection problem — retrying…' : lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : 'Connecting…'}
        </div>
      </header>

      {loading ? (
        <div className="max-w-7xl mx-auto text-center text-slate-400 py-20">Loading orders…</div>
      ) : (
        <div className="max-w-7xl mx-auto grid grid-cols-1 md:grid-cols-2 gap-6">
          <section className="rounded-3xl bg-blue-950/60 border border-blue-900/70 overflow-hidden">
            <div className="px-6 py-5 bg-blue-900/50 border-b border-blue-800/60">
              <h1 className="text-2xl md:text-3xl font-extrabold tracking-wide">PREPARING</h1>
              <p className="text-blue-200/70 mt-1">We are preparing your order</p>
            </div>
            <div className="p-6 grid grid-cols-2 sm:grid-cols-3 gap-4">
              {preparing.length === 0 ? (
                <div className="col-span-full py-12 text-center text-slate-500 text-lg">No orders currently being prepared</div>
              ) : preparing.map((order) => (
                <div key={order.id} className="rounded-2xl bg-slate-900/80 border border-blue-900/60 p-5 text-center">
                  <div className="text-xs uppercase tracking-widest text-slate-500 mb-2">Order</div>
                  <div className="text-3xl md:text-4xl font-black">{getCustomerOrderNumber(order)}</div>
                </div>
              ))}
            </div>
          </section>

          <section className="rounded-3xl bg-emerald-950/60 border border-emerald-900/70 overflow-hidden">
            <div className="px-6 py-5 bg-emerald-900/50 border-b border-emerald-800/60">
              <h1 className="text-2xl md:text-3xl font-extrabold tracking-wide">READY FOR PICKUP</h1>
              <p className="text-emerald-200/70 mt-1">Please collect your order</p>
            </div>
            <div className="p-6 grid grid-cols-2 sm:grid-cols-3 gap-4">
              {ready.length === 0 ? (
                <div className="col-span-full py-12 text-center text-slate-500 text-lg">No orders are ready yet</div>
              ) : ready.map((order) => (
                <div key={order.id} className="rounded-2xl bg-slate-900/80 border border-emerald-900/60 p-5 text-center">
                  <div className="text-xs uppercase tracking-widest text-slate-500 mb-2">Order</div>
                  <div className="text-3xl md:text-4xl font-black">{getCustomerOrderNumber(order)}</div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
